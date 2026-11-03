<script setup lang="ts">
type Translate = (en: string, zh: string) => string

defineProps<{
  tr: Translate
}>()
</script>

<template>
  <details class="holiday-index-help" data-attendance-help="holiday-index">
    <summary>{{ tr('Attendance help', '考勤帮助') }}</summary>
    <div class="holiday-index-help__panel">
      <p>
        {{
          tr(
            'After a holiday sync, each day of a festival carries a day number. The number in the holiday name is that index: 春节-1 is day 1, 国庆-4 is day 4. Names like 第3天 or DAY 3 count the same way.',
            '节假日同步之后，节日的每一天都有一个序号。名称里的数字就是序号：「春节-1」是第 1 天，「国庆-4」是第 4 天。「第3天」或「DAY 3」同样算序号。',
          )
        }}
      </p>
      <figure class="holiday-index-help__figure">
        <figcaption>{{ tr('Example: a 5-day holiday, this group only rests the first 3 days', '示例：法定休 5 天，这个考勤组只休前 3 天') }}</figcaption>
        <ol class="holiday-index-help__strip" aria-hidden="true">
          <li class="holiday-index-help__day holiday-index-help__day--rest"><span>1</span><small>{{ tr('Rest', '休') }}</small></li>
          <li class="holiday-index-help__day holiday-index-help__day--rest"><span>2</span><small>{{ tr('Rest', '休') }}</small></li>
          <li class="holiday-index-help__day holiday-index-help__day--rest"><span>3</span><small>{{ tr('Rest', '休') }}</small></li>
          <li class="holiday-index-help__day holiday-index-help__day--work"><span>4</span><small>{{ tr('Work', '班') }}</small></li>
          <li class="holiday-index-help__day holiday-index-help__day--work"><span>5</span><small>{{ tr('Work', '班') }}</small></li>
        </ol>
        <p class="holiday-index-help__callout">
          {{ tr('Start 4 and end 5 change only days 4 and 5 into workdays.', '起始填 4、结束填 5，只把第 4 天和第 5 天改成工作日。') }}
        </p>
      </figure>
      <ul>
        <li>
          {{
            tr(
              'Leave all three empty to cover the whole matched holiday. Fill them only when the rule should hit some days and skip others.',
              '三项都留空时，规则覆盖整个匹配到的节日。只有需要「只作用于其中几天」时才填写。',
            )
          }}
        </li>
        <li>
          {{
            tr(
              'Start and end are an inclusive range. Start 1 and end 6 means days 1 through 6.',
              '起始和结束是含首尾的连续区间。起始 1、结束 6 表示第 1 天到第 6 天。',
            )
          }}
        </li>
        <li>
          {{
            tr(
              'The list names exact days, such as 1,2. If a list and a range are both set, a day must be in the list and inside the range.',
              '列表只点名若干天，例如 1,2。列表和区间同时填写时，当天必须既在列表里，又落在区间内。',
            )
          }}
        </li>
        <li>
          {{
            tr(
              'If a holiday name has no day number, a rule that sets any of these fields will not match that day.',
              '节日名称里解析不出序号时，只要填了其中任意一项，这条规则就不会命中这一天。',
            )
          }}
        </li>
      </ul>
      <p>
        {{
          tr(
            'Use them for partial holiday pay (for example, base hours on days 1–6 only) or when a group rests fewer days than the statutory holiday. The group quick-add writes start and end for that shorter rest. Everyday rules that follow the whole holiday, or a specific date, can leave this advanced group closed.',
            '适合两种情况：只给节日中的几天发基准工时（例如第 1–6 天按 8 小时）；或某个考勤组比法定假期少休几天。班组快捷添加会自动写好起始和结束。按整段节日或具体日期配置时，不用打开这一组高级项。',
          )
        }}
      </p>
    </div>
  </details>
</template>

<style scoped>
.holiday-index-help {
  width: fit-content;
  max-width: 36rem;
  color: var(--ms-text-2, #475467);
  font-size: 12px;
}

.holiday-index-help summary {
  width: fit-content;
  padding: 4px 10px;
  border: 1px solid var(--ms-border, #d0d5dd);
  border-radius: 999px;
  background: var(--ms-bg-card, #fff);
  color: var(--ms-text-1, #1f2329);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.holiday-index-help__panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
  padding: 12px;
  border: 1px solid var(--ms-border-light, #eaecf0);
  border-radius: 12px;
  background: var(--ms-bg-card, #fff);
}

.holiday-index-help__panel p,
.holiday-index-help__panel ul {
  margin: 0;
}

.holiday-index-help__panel ul {
  padding-left: 18px;
}

.holiday-index-help__panel li + li {
  margin-top: 4px;
}

.holiday-index-help__figure {
  margin: 0;
  padding: 10px;
  border-radius: 10px;
  background: var(--ms-bg-page, #f8fafc);
}

.holiday-index-help__figure figcaption {
  margin-bottom: 8px;
  color: var(--ms-text-2, #475467);
  font-size: 12px;
}

.holiday-index-help__strip {
  display: flex;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.holiday-index-help__day {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 44px;
  border-radius: 8px;
  font-weight: 600;
}

.holiday-index-help__day span {
  font-size: 13px;
  line-height: 1;
}

.holiday-index-help__day small {
  margin-top: 2px;
  font-size: 10px;
  font-weight: 500;
}

.holiday-index-help__day--rest {
  background: #fff7ed;
  color: #9a3412;
}

.holiday-index-help__day--work {
  background: #ecfdf3;
  color: #166534;
  box-shadow: inset 0 0 0 1px #86efac;
}

.holiday-index-help__callout {
  margin-top: 8px;
  color: var(--ms-text-1, #1f2329);
  font-weight: 600;
}
</style>
