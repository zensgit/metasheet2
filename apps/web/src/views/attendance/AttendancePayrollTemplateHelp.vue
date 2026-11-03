<script setup lang="ts">
type Translate = (en: string, zh: string) => string

defineProps<{
  tr: Translate
}>()
</script>

<template>
  <details class="payroll-help" data-attendance-help="payroll-template">
    <summary>{{ tr('Attendance help', '考勤帮助') }}</summary>
    <div class="payroll-help__panel">
      <p>
        {{
          tr(
            'A template names a payroll window. Creating or generating cycles on the next page is what writes cycle rows.',
            '模板只定义一个计薪窗口。真正写出周期行，是在下一页「计薪周期」里创建或批量生成。',
          )
        }}
      </p>
      <ol class="payroll-help__steps">
        <li>
          <strong>{{ tr('1. Window', '1. 窗口') }}</strong>
          <p>
            {{
              tr(
                'Start day and end day are calendar days (1–31). End month offset is this month or next month. If the offset is this month and the end day is earlier than the start day, the window is treated as next month. The anchor day decides the month: on or after the start day uses that month; before it uses the previous month.',
                '起始日和结束日是日历日（1–31）。结束月偏移是当月或次月。偏移为当月且结束日早于起始日时，窗口按次月计算。锚点落在起始日当天或之后，用锚点所在月；更早则用上一个月。',
              )
            }}
          </p>
        </li>
        <li>
          <strong>{{ tr('2. Timezone', '2. 时区') }}</strong>
          <p>
            {{
              tr(
                'Chinese shows a place name, such as UTC+08:00 · 台北. The saved value is still the IANA id, such as Asia/Taipei. It is stored with the template and shown as the cycle page’s timezone hint. The start and end dates themselves follow the anchor’s calendar day, not a timezone shift of that day.',
                '中文界面显示地名，例如 UTC+08:00 · 台北。保存的仍是 IANA 标识，例如 Asia/Taipei。它随模板保存，并出现在计薪周期页的时区提示里。起止日期按锚点的日历日计算，不因时区把这一天再挪一天。',
              )
            }}
          </p>
        </li>
        <li>
          <strong>{{ tr('3. Default and auto-generate', '3. 默认与自动生成') }}</strong>
          <p>
            {{
              tr(
                'Default is the template batch generation uses when no template is chosen. Auto-generate is saved on the template. It does not create cycles when you save this page. Use Create cycle or Generate cycles for that.',
                '「默认」是批量生成未指定模板时使用的那一份。「自动生成」只随模板保存。在本页点保存不会因此写出周期。要生成周期，用计薪周期页的「创建周期」或「生成周期」。',
              )
            }}
          </p>
        </li>
        <li>
          <strong>{{ tr('4. Summary fields', '4. 汇总字段') }}</strong>
          <p>
            {{
              tr(
                'Tick the columns for payroll summary and CSV export, then move them up or down. That order is stored as summaryFieldCodes in the JSON config. Leave every box unticked to keep the backend default columns. Reload fields refreshes the choices from the report-field catalog and does not change a saved template until you save.',
                '勾选计薪汇总和 CSV 要带的列，再用上移、下移排顺序。顺序写入配置里的 summaryFieldCodes。全部不选时，汇总和导出使用后端默认列。「重载字段」只刷新统计字段目录里的可选项，保存模板之前不会改已存模板。',
              )
            }}
          </p>
        </li>
      </ol>
      <figure class="payroll-help__figure">
        <figcaption>{{ tr('Start day 1, end day 29, this month', '起始日 1、结束日 29、当月') }}</figcaption>
        <div class="payroll-help__window" aria-hidden="true">
          <span>{{ tr('Anchor on/after day 1', '锚点在 1 日或之后') }}</span>
          <strong>{{ tr('1st–29th of that month', '该月 1 日–29 日') }}</strong>
          <span>{{ tr('Anchor before day 1', '锚点早于起始日') }}</span>
          <strong>{{ tr('1st–29th of the previous month', '上月 1 日–29 日') }}</strong>
        </div>
      </figure>
    </div>
  </details>
</template>

<style scoped>
.payroll-help {
  font-size: 13px;
  color: var(--ms-text-2, #667085);
}

.payroll-help summary {
  cursor: pointer;
  color: var(--ms-color-primary, #2563eb);
  font-weight: 600;
}

.payroll-help__panel {
  display: grid;
  gap: 12px;
  margin-top: 8px;
  padding: 12px;
  border: 1px solid var(--ms-border-light, #eaecf0);
  border-radius: 8px;
  background: var(--ms-bg-page, #f8fafc);
  color: var(--ms-text-1, #1f2329);
}

.payroll-help__steps {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.payroll-help__steps p {
  margin: 4px 0 0;
}

.payroll-help__figure {
  margin: 0;
  display: grid;
  gap: 8px;
}

.payroll-help__window {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 10px;
  align-items: center;
}

.payroll-help__window span,
.payroll-help__window strong {
  padding: 6px 8px;
  border-radius: 6px;
  background: #fff;
}

.payroll-help__window strong {
  border-left: 3px solid #1d4ed8;
}
</style>
