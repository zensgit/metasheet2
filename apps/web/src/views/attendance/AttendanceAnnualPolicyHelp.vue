<script setup lang="ts">
type Translate = (en: string, zh: string) => string

defineProps<{
  tr: Translate
}>()
</script>

<template>
  <details class="annual-policy-help" data-attendance-help="annual-policy">
    <summary>{{ tr('Attendance help', '考勤帮助') }}</summary>
    <div class="annual-policy-help__panel">
      <p>
        {{
          tr(
            'This page only saves the annual-leave engine. It does not change shift or punch timezones. Save after each edit.',
            '本页只保存年假引擎。它不改变班次或打卡时区。改完后要点「保存策略」。',
          )
        }}
      </p>
      <ol class="annual-policy-help__steps">
        <li>
          <strong>{{ tr('1. Enable', '1. 启用') }}</strong>
          <p>
            {{
              tr(
                'Off (default): accrual, manual adjustment, and expiry backfill stay blocked. On: a timezone is required, or save is refused.',
                '关闭（默认）时，发放、手工调整和过期回填都会被拦住。打开后必须选择时区，否则无法保存。',
              )
            }}
          </p>
        </li>
        <li>
          <strong>{{ tr('2. Tenure mode', '2. 工龄口径') }}</strong>
          <p>
            {{
              tr(
                'Cumulative service counts completed years from the cumulative-service start date. Company tenure counts them from the hire date. Both still require a hire date. A person is eligible only after 12 continuous months from that anchor. Someone hired during the entitlement year is prorated by the remaining calendar days in that year ÷ 365, using the hire date.',
                '累计工龄按「累计工龄起算日」算满年；本单位工龄按入职日算满年。两种口径都还要有入职日。从该起算日连续满 12 个月才有资格。入职就在发放年度内的人，按该年剩余日历天数 ÷ 365 折算，折算锚点是入职日。',
              )
            }}
          </p>
        </li>
        <li>
          <strong>{{ tr('3. Standard workday minutes', '3. 标准工作日（分钟）') }}</strong>
          <p>
            {{
              tr(
                'Granted minutes = entitled days × this number. 480 means an 8-hour day. The same number converts an approved annual-leave request into balance minutes.',
                '发放分钟 = 应得天数 × 这个数字。480 就是 8 小时工作日。批准年假时，也用它把请假时长折成余额分钟。',
              )
            }}
          </p>
        </li>
        <li>
          <strong>{{ tr('4. Timezone', '4. 时区') }}</strong>
          <p>
            {{
              tr(
                'The menu shows a place name in Chinese. The saved value is still the IANA id, such as Asia/Shanghai. It sets the annual-leave calendar only: lot expiry is 1 January 00:00 in this zone, and the monthly scheduler uses it to decide which year and month “today” is. An invalid id is rejected so expiry is never silently stamped in UTC.',
                '中文界面下列表显示地名（例如北京、台北）。提交给接口的仍是 IANA 标识，例如 Asia/Shanghai。它只决定年假日历：额度在该时区每年 1 月 1 日 00:00 到期；每月自动发放也用它判断「今天」属于哪一年、哪一月。非法标识会被拒绝，避免到期时间被悄悄算成 UTC。',
              )
            }}
          </p>
        </li>
        <li>
          <strong>{{ tr('5. Carry-over', '5. 跨年结转') }}</strong>
          <p>
            {{
              tr(
                'Off: a lot for year Y expires at 1 January Y+1 00:00 in this timezone. On: it lasts through the next year and expires at 1 January Y+2 00:00. Lots already granted keep the expiry from the run that created them.',
                '关闭：Y 年的额度在该时区 Y+1 年 1 月 1 日 00:00 失效。打开：可再用一年，到 Y+2 年 1 月 1 日 00:00 失效。已经发出的额度仍按当时那次发放记下的到期时间，不会因现在改开关而改写。',
              )
            }}
          </p>
        </li>
        <li>
          <strong>{{ tr('6. Scheduler status', '6. 自动发放状态') }}</strong>
          <p>
            {{
              tr(
                'The monthly checkbox only saves this organization’s setting. A real automatic run also needs the answering process to have ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED and ATTENDANCE_SCHEDULER_ENABLED set to the literal true, plus Enable and a valid timezone. The status card is that one process’s snapshot, not a promise that every instance is running. Manual accrual on the operations page does not use those server switches.',
                '「每月自动运行计提」只记下本组织的设置。真正自动跑还要：应答进程把 ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED 和 ATTENDANCE_SCHEDULER_ENABLED 设成字面量 true，并且上方「启用」打开、时区合法。状态卡是这一次应答进程的快照，不能据此认为每台实例都在跑。年假操作页里的手工发放不看这两个服务端开关。',
              )
            }}
          </p>
        </li>
        <li>
          <strong>{{ tr('7. Edit the tier ladder', '7. 编辑工龄阶梯') }}</strong>
          <p>
            {{
              tr(
                'Each row is a band of completed years and the days it grants. A year count matches the first band where years ≥ start and (end is blank or years < end). Bands must touch: the next start equals the previous end. Only the last end may be blank (and above). Then save.',
                '每一行是一段已满年数，以及这段对应的天数。年数落入「≥ 起始年，且截止年留空或 < 截止年」的第一段。各段必须接上：下一段起始年等于上一段截止年。只有最后一段的截止年可以留空（及以上）。改完再保存。',
              )
            }}
          </p>
        </li>
      </ol>
      <figure class="annual-policy-help__figure">
        <figcaption>{{ tr('Example ladder, then when a 2026 lot expires', '示例阶梯，以及 2026 年额度何时到期') }}</figcaption>
        <ol class="annual-policy-help__ladder" aria-hidden="true">
          <li><span>1–10</span><strong>5</strong><small>{{ tr('days', '天') }}</small></li>
          <li><span>10–20</span><strong>10</strong><small>{{ tr('days', '天') }}</small></li>
          <li><span>20+</span><strong>15</strong><small>{{ tr('days', '天') }}</small></li>
        </ol>
        <div class="annual-policy-help__expiry" aria-hidden="true">
          <span>{{ tr('Granted for 2026', '2026 年发放') }}</span>
          <span class="annual-policy-help__expiry-off">{{ tr('No carry-over → 1 Jan 2027 00:00', '不结转 → 2027-01-01 00:00') }}</span>
          <span class="annual-policy-help__expiry-on">{{ tr('Carry-over → 1 Jan 2028 00:00', '结转 → 2028-01-01 00:00') }}</span>
        </div>
      </figure>
    </div>
  </details>
</template>

<style scoped>
.annual-policy-help {
  font-size: 13px;
  color: var(--ms-text-2, #667085);
}

.annual-policy-help summary {
  cursor: pointer;
  color: var(--ms-color-primary, #2563eb);
  font-weight: 600;
}

.annual-policy-help__panel {
  display: grid;
  gap: 12px;
  margin-top: 8px;
  padding: 12px;
  border: 1px solid var(--ms-border-light, #eaecf0);
  border-radius: 8px;
  background: var(--ms-bg-page, #f8fafc);
  color: var(--ms-text-1, #1f2329);
}

.annual-policy-help__steps {
  display: grid;
  gap: 10px;
  margin: 0;
  padding-left: 0;
  list-style: none;
}

.annual-policy-help__steps p {
  margin: 4px 0 0;
}

.annual-policy-help__figure {
  margin: 0;
  display: grid;
  gap: 8px;
}

.annual-policy-help__ladder {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.annual-policy-help__ladder li {
  display: grid;
  justify-items: center;
  min-width: 72px;
  padding: 8px;
  border-radius: 8px;
  background: #dbeafe;
  color: #1e3a8a;
}

.annual-policy-help__ladder strong {
  font-size: 18px;
  line-height: 1.2;
}

.annual-policy-help__expiry {
  display: grid;
  gap: 6px;
}

.annual-policy-help__expiry span {
  padding: 6px 8px;
  border-radius: 6px;
  background: #fff;
}

.annual-policy-help__expiry-off {
  border-left: 3px solid #b45309;
}

.annual-policy-help__expiry-on {
  border-left: 3px solid #047857;
}
</style>
